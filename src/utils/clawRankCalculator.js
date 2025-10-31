export const calculateClawRank = (metrics) => {
  const {
    postsCount = 0,
    upvotesReceived = 0,
    commentsCount = 0,
    projectsCount = 0,
    daysActive = 0,
  } = metrics;

  // Calculate innovation score (complexity of posts/projects)
  const innovationScore = projectsCount * 10 + postsCount * 5;
  
  // Calculate impact score (engagement and upvotes)
  const impactScore = upvotesReceived * 2 + commentsCount;
  
  // Calculate activity score (consistency)
  const activityScore = Math.min(daysActive * 0.5, 50);
  
  // Total score
  const totalScore = innovationScore + impactScore + activityScore;

  // Determine rank
  if (totalScore >= 500) {
    return 'quantum';
  } else if (totalScore >= 200) {
    return 'titanium';
  } else if (totalScore >= 50) {
    return 'silver';
  } else {
    return 'bronze';
  }
};

export const getRankMetrics = async (userId, supabase) => {
  try {
    // Get user's posts count
    const { count: postsCount } = await supabase
      .from('posts')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId);

    // Get user's posts IDs first
    const { data: userPosts } = await supabase
      .from('posts')
      .select('id')
      .eq('user_id', userId);

    const postIds = userPosts?.map(p => p.id) || [];

    // Get upvotes received on user's posts
    let upvotesReceived = 0;
    if (postIds.length > 0) {
      const { count } = await supabase
        .from('upvotes')
        .select('*', { count: 'exact', head: true })
        .in('post_id', postIds);
      upvotesReceived = count || 0;
    }

    // Get comments count
    const { count: commentsCount } = await supabase
      .from('comments')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId);

    // Get projects count (posts with category 'project')
    const { count: projectsCount } = await supabase
      .from('posts')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('category', 'project');

    // Calculate days active (from profile created_at)
    const { data: profile } = await supabase
      .from('profiles')
      .select('created_at')
      .eq('id', userId)
      .single();

    const daysActive = profile?.created_at
      ? Math.floor((Date.now() - new Date(profile.created_at).getTime()) / (1000 * 60 * 60 * 24))
      : 0;

    return {
      postsCount: postsCount || 0,
      upvotesReceived,
      commentsCount: commentsCount || 0,
      projectsCount: projectsCount || 0,
      daysActive,
    };
  } catch (error) {
    console.error('Error calculating rank metrics:', error);
    return {
      postsCount: 0,
      upvotesReceived: 0,
      commentsCount: 0,
      projectsCount: 0,
      daysActive: 0,
    };
  }
};

