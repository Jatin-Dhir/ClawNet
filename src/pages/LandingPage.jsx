import React from 'react';
import { useOutletContext } from 'react-router-dom';
import Hero from '../components/Hero';
import ExploreNavigator from '../components/ExploreNavigator';
import About from '../components/About';
import TeamPreview from '../components/TeamPreview';
import Products from '../components/Products';
import Blog from '../components/Blog';
import Stats from '../components/Stats';
import CommunityIntro from '../components/community/CommunityIntro';

const LandingPage = () => {
  const { onSignInClick, triggerTransition } = useOutletContext();

  return (
    <>
      <Hero onJoinClick={() => triggerTransition(onSignInClick)} />
      <ExploreNavigator onSignInClick={onSignInClick} triggerTransition={triggerTransition} />
      <About />
      <TeamPreview />
      <Products />
      <Blog />
      <CommunityIntro onSignInClick={onSignInClick} triggerTransition={triggerTransition} />
      <Stats />
    </>
  );
};

export default LandingPage;
